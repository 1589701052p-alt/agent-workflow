-- RFC-120 v2 — task_questions「待下发」(staged) 暂存态 (hand-written; additive; registered
-- in meta/_journal.json). Statements separated by the breakpoint marker below — REQUIRED
-- or only the first applies silently (RFC-108 0052/0053 incident).
--
-- 看板把「拖入待下发框、已批准但还没批量下发」的问题落 staged_at/staged_by；
-- deriveQuestionPhase 据此在「未下发」里区分 staged(待下发) vs pending(待指派)。
-- 任务 gate（design §11.2）：phase ∈ {pending, staged} 即「未下发」、任务停 awaiting_human。
-- Additive；不动既有 0060 列。
ALTER TABLE `task_questions` ADD COLUMN `staged_at` integer;
--> statement-breakpoint
ALTER TABLE `task_questions` ADD COLUMN `staged_by` text;
