-- RFC-120 §18 — one-click batch-dispatch correct model (frontier mint + per-node queue).
-- Hand-written; additive; registered in meta/_journal.json. Two ALTER statements →
-- each needs the breakpoint separator (RFC-108 0052/0053 incident: without it only the
-- first statement applies, silently). The marker literal is written on its own line
-- below, NEVER inside a comment (or the migrator splits the comment off as empty).
--
-- dispatched_at : when set, the question is COMMITTED FOR EXECUTION (the human clicked
--   "batch-dispatch"). This is the park-gate key (undispatched = dispatched_at IS NULL)
--   and is DISTINCT from trigger_run_id, which now binds the question to the specific
--   handler run that renders it (stamped at the node's RERUN, not at batch-dispatch).
-- dispatched_by : audit-only actor id of the human who dispatched it. UI/audit ONLY —
--   NEVER enters an agent prompt (RFC-099 prompt-isolation).
-- Both nullable + additive; touch no existing column. Default null = today's behavior.
ALTER TABLE `task_questions` ADD COLUMN `dispatched_at` integer;
--> statement-breakpoint
ALTER TABLE `task_questions` ADD COLUMN `dispatched_by` text;
--> statement-breakpoint
-- ROLLING-UPGRADE BACKFILL (Codex ship-gate H1): the corrected gate keys on dispatched_at,
-- but rows dispatched under the PRIOR (pre-§18) contract carry trigger_run_id set + the new
-- dispatched_at NULL. Without this, the gate would mis-read those committed rows as
-- "undispatched" → re-park / duplicate mint on upgrade. Backfill dispatched_at (to the row's
-- own created_at, a stable non-null sentinel) for any task_question that is already bound
-- (trigger_run_id IS NOT NULL) and still NULL, SCOPED to deferred tasks (non-deferred never
-- used this contract → golden-lock untouched). Idempotent (the WHERE excludes already-set rows).
UPDATE `task_questions`
SET `dispatched_at` = `created_at`
WHERE `trigger_run_id` IS NOT NULL
  AND `dispatched_at` IS NULL
  AND `task_id` IN (SELECT `id` FROM `tasks` WHERE `deferred_question_dispatch` = 1);
