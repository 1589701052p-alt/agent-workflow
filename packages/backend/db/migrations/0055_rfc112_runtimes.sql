-- RFC-112 PR-A — runtime registry (hand-written; additive). Statements are
-- separated by the breakpoint marker below — REQUIRED or only the first applies
-- silently (RFC-108 0052/0053 incident; never write that literal token inside a
-- comment, or the migrator splits the comment off as an empty statement).
--
-- runtimes                : named runtime instances {name, protocol, binary_path};
--                           built-ins opencode/claude-code seeded (builtin=1) at startup.
-- node_runs.runtime_binary: RFC-112 Codex P1 — binary head snapshot frozen with
--                           `runtime` (the protocol) so resume re-spawns the exact
--                           (driver, binary) without consulting the mutable registry.
-- Additive; legacy rows stay valid (runtime_binary NULL → protocol default binary).
CREATE TABLE IF NOT EXISTS `runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`binary_path` text,
	`builtin` integer DEFAULT false NOT NULL,
	`last_probe_json` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `runtimes_name_unique` ON `runtimes` (`name`);
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `runtime_binary` text;
