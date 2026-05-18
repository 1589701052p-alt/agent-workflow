-- RFC-040: wrapper-loop / wrapper-git progress persistence so a wrapper can
-- resume from the loop iteration / git baseline where its inner scope parked
-- on awaiting_human / awaiting_review, instead of either swallowing the
-- signal (today's bug — produces N ghost clarify/review rows) or restarting
-- from scratch on daemon reboot. NULL on legacy rows and on non-wrapper
-- runs; only `services/wrapperProgress.ts` writes / parses this column.
ALTER TABLE `node_runs` ADD `wrapper_progress_json` text;
