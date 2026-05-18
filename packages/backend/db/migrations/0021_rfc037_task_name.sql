-- RFC-037: user-supplied task name (required at launch time, displayed in
-- list / detail / inbox). SQLite ALTER TABLE cannot add a NOT NULL column
-- without a default expression that yields constants, so we add the column
-- as nullable, backfill from workflows.name (fallback to "task-{shortId}"),
-- and rely on the drizzle schema + zod StartTaskSchema to enforce NOT NULL
-- on all subsequent inserts. Once backfilled the column is effectively
-- non-null; future writers cannot insert empty strings either (StartTaskSchema
-- rejects empty / whitespace-only names before reaching INSERT).
ALTER TABLE `tasks` ADD `name` text;
--> statement-breakpoint
UPDATE `tasks`
SET `name` = COALESCE(
  (SELECT `name` FROM `workflows` WHERE `workflows`.`id` = `tasks`.`workflow_id`),
  'task-' || substr(`id`, -10)
)
WHERE `name` IS NULL OR `name` = '';
