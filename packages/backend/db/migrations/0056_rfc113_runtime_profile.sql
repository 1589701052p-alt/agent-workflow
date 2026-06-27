-- RFC-113 PR-A — runtime IS a full execution profile (hand-written; additive).
-- Statements separated by the breakpoint marker below — REQUIRED or only the
-- first applies silently (RFC-108 0052/0053 incident; never write that literal
-- token inside a comment, or the migrator splits the comment off as empty).
--
-- runtimes.{model,variant,temperature,steps,max_steps}: the model + generation
--   params the runner spawns with (agents now only SELECT a runtime). variant/
--   temperature/steps are opencode-only (NULL for claude). NULL model = "omit".
-- node_runs.runtime_params_json: those params JSON-frozen at dispatch alongside
--   runtime/runtime_binary, so resume re-spawns the exact same profile.
-- Additive; legacy rows stay valid (all NULL → live resolution / built-in default).
ALTER TABLE `runtimes` ADD COLUMN `model` text;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `variant` text;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `temperature` real;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `steps` integer;
--> statement-breakpoint
ALTER TABLE `runtimes` ADD COLUMN `max_steps` integer;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `runtime_params_json` text;
