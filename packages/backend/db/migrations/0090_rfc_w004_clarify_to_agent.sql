-- RFC-W004 - clarify-to-agent: add `kind='to-agent'` to clarify_rounds +
-- answerer tracking columns.
--
-- to-agent (B reverse-asks upstream A; A answers via <workflow-clarify-answer>)
-- is the third clarify family after self (RFC-023) and cross (RFC-056). It
-- reuses `awaiting_human` as the session status (T4 design simplification -
-- no new status value), so the `status` CHECK is unchanged. Only the `kind`
-- CHECK + the cross-domain composite CHECK need widening, plus two new
-- answerer columns.
--
-- SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table
-- (standard 12-step pattern, cf. migration 0041 which rebuilt node_runs the
-- same way). The new shape mirrors the current `clarify_rounds` (schema.ts
-- SSOT) PLUS `answerer_node_id` / `answerer_node_run_id`, and widens both
-- CHECKs to admit `kind='to-agent'`. Column list is explicit on both sides of
-- the copy so the shape is locked. The platform is pre-prod (no live user
-- data); hard-cut is safe.
--
-- Composite CHECK widening: to-agent allows BOTH abandoned (A fail -> CR-1
-- invariant upgrade, like cross) AND canceled (task-cancel path, like self),
-- so it is exempt from both restrictions.
--
-- See design/RFC-W004-clarify-to-agent/design.md §2.6.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_clarify_rounds` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN ('self', 'cross', 'to-agent')),
  `asking_node_id` text NOT NULL,
  `asking_node_run_id` text NOT NULL,
  `asking_shard_key` text,
  `intermediary_node_id` text NOT NULL,
  `intermediary_node_run_id` text NOT NULL,
  `target_consumer_node_id` text,
  `answerer_node_id` text,
  `answerer_node_run_id` text,
  `loop_iter` integer NOT NULL DEFAULT 0,
  `iteration` integer NOT NULL DEFAULT 0,
  `questions_json` text NOT NULL,
  `answers_json` text,
  `directive` text CHECK (`directive` IS NULL OR `directive` IN ('continue', 'stop')),
  `status` text NOT NULL DEFAULT 'awaiting_human'
    CHECK (`status` IN ('awaiting_human', 'answered', 'canceled', 'abandoned')),
  `truncation_warnings_json` text,
  `designer_run_triggered_at` integer,
  `abandoned_at` integer,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  `answered_at` integer,
  `answered_by` text,
  `submitted_by_role` text,
  `answer_attributions_json` text,
  `draft_answers_json` text,
  `question_scopes_json` text,
  CHECK (
    (`kind` = 'to-agent') OR
    (`kind` = 'self'  AND `status` != 'abandoned') OR
    (`kind` = 'cross' AND `status` != 'canceled')
  ),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`intermediary_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`asking_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`answerer_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_clarify_rounds` (
  `id`, `task_id`, `kind`,
  `asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
  `intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
  `answerer_node_id`, `answerer_node_run_id`,
  `loop_iter`, `iteration`,
  `questions_json`, `answers_json`, `directive`, `status`,
  `truncation_warnings_json`,
  `designer_run_triggered_at`, `abandoned_at`,
  `created_at`, `answered_at`, `answered_by`,
  `submitted_by_role`, `answer_attributions_json`, `draft_answers_json`, `question_scopes_json`
)
SELECT
  `id`, `task_id`, `kind`,
  `asking_node_id`, `asking_node_run_id`, `asking_shard_key`,
  `intermediary_node_id`, `intermediary_node_run_id`, `target_consumer_node_id`,
  NULL, NULL,
  `loop_iter`, `iteration`,
  `questions_json`, `answers_json`, `directive`, `status`,
  `truncation_warnings_json`,
  `designer_run_triggered_at`, `abandoned_at`,
  `created_at`, `answered_at`, `answered_by`,
  `submitted_by_role`, `answer_attributions_json`, `draft_answers_json`, `question_scopes_json`
FROM `clarify_rounds`;--> statement-breakpoint
DROP TABLE `clarify_rounds`;--> statement-breakpoint
ALTER TABLE `__new_clarify_rounds` RENAME TO `clarify_rounds`;--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_task` ON `clarify_rounds` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_kind_status` ON `clarify_rounds` (`kind`, `status`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_asking` ON `clarify_rounds` (`asking_node_id`, `loop_iter`, `iteration`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_intermediary` ON `clarify_rounds` (`intermediary_node_id`, `loop_iter`, `iteration`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_target_consumer` ON `clarify_rounds` (`target_consumer_node_id`, `status`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_answerer` ON `clarify_rounds` (`answerer_node_id`, `status`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
