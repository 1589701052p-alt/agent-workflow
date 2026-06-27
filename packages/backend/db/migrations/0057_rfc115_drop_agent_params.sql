-- RFC-115 PR-C — drop the dead agent generation-param columns.
--
-- RFC-113 moved model / variant / temperature / steps / maxSteps onto the
-- runtime profile (the `runtimes` row); the runner reads them from there and
-- NEVER from the agent. These five `agents` columns are now dead (re-homed to
-- NULL by RFC-113's one-time migrateAgentParamsToRuntimes, then ignored). This
-- migration drops them. `agents.runtime` (RFC-111) STAYS.
--
-- Pre-drop fail-loud guard (Codex design-gate F2): the RFC-113 re-home runs in
-- cli/start.ts AFTER `migrate()`. A DB that jumps straight from pre-0056 to this
-- version would have its params dropped BEFORE any runtime profile is created —
-- losing the only copy of the user's model/variant/temperature. So before the
-- rebuild we assert every param column is already NULL via a TEMP-table CHECK
-- trick: if ANY row still has a non-NULL param the COUNT(*) is > 0, violates
-- CHECK(n = 0), and the whole migration ABORTs (transactional → no data lost)
-- with a clear failure instead of a silent drop. A library DB that went through
-- RFC-113 once (params already NULL) passes the guard. The platform is pre-prod;
-- this guard is belt-and-suspenders over the hard-cut convention.
--
-- SQLite has no in-place DROP COLUMN in bun:sqlite's bundled runtime, so we use
-- the standard 12-step rebuild (cf. 0041 / 0035). The new table mirrors `agents`
-- MINUS the 5 param columns; the `agents_name_unique` index (0000) is recreated.
-- Column list is explicit on both sides so the dropped columns can't sneak back.
--
-- See design/RFC-115-node-policy-global-cleanup/design.md §4.1.
CREATE TEMP TABLE `__rfc115_guard` (`n` integer CHECK (`n` = 0));--> statement-breakpoint
INSERT INTO `__rfc115_guard` SELECT COUNT(*) FROM `agents`
	WHERE `model` IS NOT NULL OR `variant` IS NOT NULL OR `temperature` IS NOT NULL
		OR `steps` IS NOT NULL OR `max_steps` IS NOT NULL;--> statement-breakpoint
DROP TABLE `__rfc115_guard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`outputs` text DEFAULT '[]' NOT NULL,
	`readonly` integer DEFAULT false NOT NULL,
	`sync_outputs_on_iterate` integer DEFAULT true NOT NULL,
	`runtime` text,
	`permission` text DEFAULT '{}' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`mcp` text DEFAULT '[]' NOT NULL,
	`plugins` text DEFAULT '[]' NOT NULL,
	`frontmatter_extra` text DEFAULT '{}' NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`owner_user_id` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_agents` (
	`id`, `name`, `description`, `outputs`, `readonly`, `sync_outputs_on_iterate`,
	`runtime`, `permission`, `skills`, `depends_on`, `mcp`, `plugins`,
	`frontmatter_extra`, `body_md`, `owner_user_id`, `visibility`, `builtin`,
	`schema_version`, `created_at`, `updated_at`
)
SELECT
	`id`, `name`, `description`, `outputs`, `readonly`, `sync_outputs_on_iterate`,
	`runtime`, `permission`, `skills`, `depends_on`, `mcp`, `plugins`,
	`frontmatter_extra`, `body_md`, `owner_user_id`, `visibility`, `builtin`,
	`schema_version`, `created_at`, `updated_at`
FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
