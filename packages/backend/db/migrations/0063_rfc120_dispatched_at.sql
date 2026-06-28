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
