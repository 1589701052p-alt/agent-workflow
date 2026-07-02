-- RFC-132 T10 (PR-F, forward-only): drop the retired clarify consumption stamps + the
-- deferred-dispatch flag. Derived aging (isTargetNodeConsumed) replaced the stamps; the
-- unified model made every task deferred-dispatch (the flag has no reader). Indexes first
-- (SQLite cannot drop an indexed column).
DROP INDEX IF EXISTS `idx_clarify_sessions_consumed_consumer`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_cross_clarify_sessions_consumed_consumer`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_cross_clarify_sessions_consumed_questioner`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_clarify_rounds_consumed_consumer`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_clarify_rounds_consumed_questioner`;
--> statement-breakpoint
ALTER TABLE `clarify_sessions` DROP COLUMN `consumed_by_consumer_run_id`;
--> statement-breakpoint
ALTER TABLE `cross_clarify_sessions` DROP COLUMN `consumed_by_consumer_run_id`;
--> statement-breakpoint
ALTER TABLE `cross_clarify_sessions` DROP COLUMN `consumed_by_questioner_run_id`;
--> statement-breakpoint
ALTER TABLE `clarify_rounds` DROP COLUMN `consumed_by_consumer_run_id`;
--> statement-breakpoint
ALTER TABLE `clarify_rounds` DROP COLUMN `consumed_by_questioner_run_id`;
--> statement-breakpoint
ALTER TABLE `tasks` DROP COLUMN `deferred_question_dispatch`;
